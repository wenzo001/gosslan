/**
 * 「辅助窗口创建失败」的统一上报入口（设置 / 日志 / 外链 / 看图 共用）。
 *
 * 判据在 `utils/auxWindowFailure.ts`（纯函数、认码不认字）；这里只负责把三样真实的依赖接上去：
 * 词典（中英两套）、toast（带按钮）、既有重启路径（`api.restartApp`，与托盘/崩溃横幅同一个入口）。
 *
 * ⚠️ 不改任何窗口结构或降级策略：设置仍然回退到应用内面板、看图仍然退回覆盖层，
 * 这里只负责在失败时**说清原因**并给一个动作。
 */
import { api } from "@/api";
import { t } from "@/i18n";
import { useAppStore } from "@/stores/useAppStore";
import { reportAuxWindowFailure } from "@/utils/auxWindowFailure";

export type AuxWindowFailureVerdict = "friendly" | "fallback";

export function useAuxWindowFailureReport() {
  const app = useAppStore();
  return (e: unknown, fallbackPrefix: string): AuxWindowFailureVerdict =>
    reportAuxWindowFailure(
      e,
      {
        friendly: t("errors.rule.auxWindow"),
        restart: t("errors.rule.auxWindowRestart"),
      },
      {
        noticeWithRestart: (text, label, run) =>
          app.toastAction(text, "error", { label, run }),
        fallback: (err) => app.toastError(err, fallbackPrefix),
        restartApp: () => void api.restartApp().catch(() => {}),
      },
    );
}
