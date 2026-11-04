/**
 * 安卓升级适配层：把 `androidService` 的抽象动作接到真实 Tauri 命令上。
 *
 * 这一层刻意与桌面的 `tauriAdapter.ts` 分开 —— 两者的命令名、事件名、失败码都不同，
 * 混用只会让桌面那条稳定路径跟着冒险（用户明确要求不能带坏桌面更新）。
 * 非 Android 目标上后端命令是桩（返回 `ANDROID_UPDATE_UNSUPPORTED`），
 * 而本面板只在 `isAndroid` 时挂载，所以正常不会被调用。
 */
import { api } from "@/api";
import type { AndroidUpdateAdapter } from "./androidService";

export const androidUpdateAdapter: AndroidUpdateAdapter = {
  check: () => api.androidUpdaterCheck(),
  download: (onEvent) => api.androidUpdaterDownload(onEvent),
  verify: () => api.androidUpdaterVerify(),
  install: () => api.androidUpdaterInstall(),
  cancel: () => api.androidUpdaterCancel(),
  close: () => api.androidUpdaterClose(),
  openPermissionSettings: () => api.androidUpdaterOpenPermissionSettings(),
  onStatus: (cb) => api.androidUpdaterOnStatus(cb),
  status: () => api.androidUpdaterStatus(),
};
