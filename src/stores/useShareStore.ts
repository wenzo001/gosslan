/**
 * 外部分享到会话的前端状态：当前待处理的那一条 + 面板开关 + 失败提示节流。
 *
 * 职责边界：只持有状态与调 api，**不发送消息**（也不导入 chat store —— 那会造出
 * `share ⇄ chat` 的模块环，而发送动作只有面板知道"发到哪个会话"这件事）。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api";
import type { SharePrompt } from "@/types";
// 时间差闸门只有 `utils/defer` 一个家（`defer.test.ts` 会抓手写的 "now - last >= N"）。
import { shouldRunThrottled } from "@/utils/defer";

/** 同一条坏链接被反复触发时的提示间隔（毫秒）。 */
const SHARE_ERROR_TOAST_MS = 3000;

export const useShareStore = defineStore("externalShare", () => {
  /** 当前要处理的那一条；`null` = 面板不显示。 */
  const pending = ref<SharePrompt | null>(null);
  const visible = computed(() => pending.value !== null);

  /** 失败提示的节流时间戳：任意网页都能反复触发坏链接，不节流就是一串一样的 toast。 */
  const lastErrorAt = ref(0);

  function setPending(p: SharePrompt) {
    pending.value = p;
  }

  /**
   * 冷启动补拉：进程起来之前到达的分享，`share-request` 那一刻的事件已经发过了。
   * 读失败就当作没有 —— 下一次事件仍会正常弹出，不该因为一次读失败弹错误。
   */
  async function load(): Promise<void> {
    try {
      const p = await api.shareGetPending();
      if (p && !pending.value) pending.value = p;
    } catch {
      // 忽略：没有待处理项是常态。
    }
  }

  /**
   * 关掉这一条（用户取消 / 已发送）。**先让界面消失再清后端**：
   * 后端那条清不掉也只是按 TTL 过期，不该让面板卡在那里转圈。
   */
  async function dismiss(): Promise<void> {
    const id = pending.value?.shareId;
    pending.value = null;
    if (!id) return;
    try {
      await api.shareDismiss(id);
    } catch {
      // 同上：TTL 会兜底。
    }
  }

  /**
   * 3 秒内只提示一次（窗口级节流，跨多次坏链接）。
   *
   * 走 `shouldRunThrottled` 而不是自己写 `now - last < N`：全仓只许有一个时间差闸门，
   * 否则"到底几秒"会出现第二份定义（`src/utils/defer.test.ts` 按这个口径扫生产码）。
   */
  function shouldToastNow(now = Date.now()): boolean {
    if (!shouldRunThrottled(now, lastErrorAt.value, SHARE_ERROR_TOAST_MS)) return false;
    lastErrorAt.value = now;
    return true;
  }

  /** 清数据（`data-cleared`）时一并清掉：面板里那份内容已经没有任何后端依据。 */
  function clear() {
    pending.value = null;
  }

  return { pending, visible, setPending, load, dismiss, shouldToastNow, clear };
});
