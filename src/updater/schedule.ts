import { isAndroid, isIOS } from "@/utils/platform";
import type { UpdaterService } from "./service";

/**
 * 启动后的**一次**低优先级检查：不阻塞挂载、不轮询、失败静默、不重试。
 *
 * 只在主窗口入口调用；设置/日志窗口不自动检查（用户打开「关于」时手动检查即可）。
 * 移动端不进入应用内更新（平台不允许桌面安装器那套），直接不调度。
 */
export function scheduleAutoUpdateCheck(service: UpdaterService, delayMs = 8_000): () => void {
  if (isAndroid || isIOS) return () => {};
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  const timer = setTimeout(() => {
    // `check(false)` 的失败路径在 service 里回到 idle 且不写错误，离线时零打扰。
    void service.check(false);
  }, delayMs);
  return () => clearTimeout(timer);
}
