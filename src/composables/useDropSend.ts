/**
 * 拖拽发送的**一条**链路：读元数据 → 冻住"发给谁" → 确认框 → 逐条发送。
 *
 * 两个落点（聊天面板、左侧会话列表）共用这一份 —— 它们只决定"落在哪个会话"，
 * 之后的行为（列文件、剔目录、确认、发送、单条失败的提示）必须一模一样，
 * 否则两处各写一遍就是第二套真源（比如"列表那条忘了剔目录，点了确认才逐条报错"）。
 */
import { computed, ref } from "vue";
import { api } from "@/api";
import { t } from "@/i18n";
import { formatBytes } from "@/utils/format";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import type { DropPathInfo } from "@/types";

/** 拖进来那一刻的落点：`convId` 与那句话都冻住（确认框开着时切会话不该换收件人）。 */
export interface DropTarget {
  convId: string;
  body: string;
}

export function useDropSend() {
  const app = useAppStore();
  const chat = useChatStore();
  const pending = ref<{ target: DropTarget; paths: string[]; files: DropPathInfo[] } | null>(null);

  /** 确认框正文（拖进来那一刻冻结的）。 */
  const body = computed(() => pending.value?.target.body ?? "");
  /** 确认框条目：一行一个文件（名字 + 大小）。 */
  const items = computed(() =>
    (pending.value?.files ?? []).map((f) =>
      f.size > 0 ? `${f.name} · ${formatBytes(f.size)}` : f.name,
    ),
  );

  /** 逐条发送（单个失败不阻塞其余；后端会把失败的那条写成 failed 状态）。 */
  async function sendFiles(convId: string, paths: string[]) {
    for (const p of paths) {
      try {
        if (convId.startsWith("group:")) {
          await chat.sendGroupFileTo(convId.slice("group:".length), p);
        } else {
          await chat.sendFileTo(convId, p);
        }
      } catch (e) {
        app.toastError(e, t("msg.sendFailed"));
      }
    }
  }

  /**
   * 先**停在确认框**上：读元数据（名字/大小/是否目录），目录当场剔掉。
   *
   * stat 失败也要能发：退回"只有名字"的那种确认，发送链路自己会再校验一次。
   */
  async function stage(paths: string[], target: DropTarget) {
    let files: DropPathInfo[] = [];
    try {
      files = await api.inspectDropPaths(paths);
    } catch {
      files = paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: 0,
        isDir: false,
      }));
    }
    const usable = files.filter((f) => !f.isDir);
    if (usable.length === 0) {
      app.toast(t("chat.dropNoFiles"), "error");
      return;
    }
    pending.value = { target, paths: usable.map((f) => f.path), files: usable };
  }

  function confirm() {
    const batch = pending.value;
    pending.value = null;
    if (!batch) return;
    void sendFiles(batch.target.convId, batch.paths);
  }

  function cancel() {
    pending.value = null;
  }

  return { pending, body, items, stage, confirm, cancel, sendFiles };
}
