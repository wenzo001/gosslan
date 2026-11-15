import { api } from "@/api";
import type { UpdaterAdapter } from "./service";

/** Rust 命令适配层：所有 IPC 仍走 `src/api` 门面（组件/工具层不直接 invoke）。 */
export const tauriUpdaterAdapter: UpdaterAdapter = {
  check: () => api.updaterCheck(),
  checkSource: (source) => api.updaterCheckSource(source),
  /** 用户显式选源 ⇒ 后端落盘记住（下次默认用它）。 */
  setSourcePref: (source) => api.updaterSetSourcePref(source),
  download: (onEvent) => api.updaterDownload(onEvent),
  cancel: () => api.updaterCancel(),
  recheckReady: () => api.updaterRecheckReady(),
  install: () => api.updaterInstall(),
  close: () => api.updaterClose(),
};
