import { version } from "../../package.json";
import { createUpdaterService } from "./service";
import { tauriUpdaterAdapter } from "./tauriAdapter";

/** 每个窗口一份 UI 状态；真正的检查/下载任务由 Rust 侧串行化（跨窗口也只允许一个）。 */
export const updater = createUpdaterService(tauriUpdaterAdapter, { currentVersion: version });
