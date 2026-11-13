import { useAppStore } from "@/stores/useAppStore";
import { copyText } from "@/utils/crashReport";
import { t } from "@/i18n";

/**
 * 轻量复制动作（群任务详情双击标题/描述等）的统一反馈。
 *
 * 复制本体走 `utils/crashReport::copyText`（clipboard API + execCommand 回退），
 * 这里只把结果说给用户：成功「已复制」、失败「复制失败」，与消息复制那条 toast
 * 同口径（`common.copied` / `msg.copyFail`），不另造文案。空串不触发（无内容可复制）。
 */
export function useCopyToast() {
  const app = useAppStore();
  return async function copyWithToast(text: string): Promise<void> {
    if (!text) return;
    const ok = await copyText(text);
    app.toast(ok ? t("common.copied") : t("msg.copyFail"), ok ? "success" : "error");
  };
}