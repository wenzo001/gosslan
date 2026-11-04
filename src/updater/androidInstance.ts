/**
 * 全局唯一的安卓更新服务实例（设置面板与未来的入口共用一份状态）。
 *
 * `version` 来自 `package.json`：它与 Android 的 `versionName` 同源（发布流水线按同一份
 * 版本号写 `tauri.properties`），所以「当前版本」不需要再走一次 IPC。
 */
import { version } from "../../package.json";
import { androidUpdateAdapter } from "./androidAdapter";
import { createAndroidUpdaterService } from "./androidService";

export const androidUpdater = createAndroidUpdaterService(androidUpdateAdapter, {
  currentVersion: version,
});
