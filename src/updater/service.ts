/**
 * 更新状态机（纯逻辑，不 import Tauri）：
 * 单飞检查/下载、超时、取消、错误分类、稍后处理。
 *
 * 真实网络与安装动作由 `UpdaterAdapter` 提供（`tauriAdapter.ts` 对接 Rust 命令），
 * 这样 `node --test` 能用可控的假适配器把离线、超时、取消、重复点击都跑一遍。
 */
import { reactive } from "vue";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error";

export type UpdaterErrorCode = "timeout" | "network" | "signature" | "manifest" | "busy" | "unknown";

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes?: string | null;
  /** Unix seconds（Rust 侧给的是时间戳，不在后端格式化文案）。 */
  publishedAt?: number | null;
}

export type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number | null } }
  | { event: "Progress"; data?: { chunkLength?: number } }
  | { event: "Finished"; data?: undefined };

export interface UpdaterAdapter {
  check(): Promise<UpdateInfo | null>;
  download(onEvent: (event: DownloadEvent) => void): Promise<void>;
  cancel(): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdaterState {
  phase: UpdaterPhase;
  info: UpdateInfo | null;
  currentVersion: string;
  downloaded: number;
  total: number | null;
  error: UpdaterErrorCode | null;
  checkedAt: number | null;
  dismissedVersion: string | null;
}

export const UPDATER_CANCELLED = "UPDATER_CANCELLED";
const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

function errorCode(e: unknown): UpdaterErrorCode {
  const text = String((e as { message?: unknown })?.message ?? e);
  if (/UPDATER_CANCELLED|cancel/i.test(text)) return "unknown";
  if (/timeout|timed? ?out|超时/i.test(text)) return "timeout";
  if (/签名|signature|verify/i.test(text)) return "signature";
  if (/json|manifest|清单|格式/i.test(text)) return "manifest";
  if (/正在进行|已在下载|正在下载|busy/i.test(text)) return "busy";
  if (/network|dns|http|连接|下载失败|不可达|unreachable/i.test(text)) return "network";
  return "unknown";
}

export function createUpdaterService(
  adapter: UpdaterAdapter,
  options: { currentVersion?: string; checkTimeoutMs?: number } = {},
) {
  const state = reactive<UpdaterState>({
    phase: "idle",
    info: null,
    currentVersion: options.currentVersion ?? "",
    downloaded: 0,
    total: null,
    error: null,
    checkedAt: null,
    dismissedVersion: null,
  });

  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let attempt = 0;
  let checkInFlight: Promise<void> | null = null;
  let downloadInFlight: Promise<void> | null = null;
  let cancelRequested = false;

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        reject(new Error("timeout"));
      }, ms);
      timers.add(timer);
      promise.then(
        (value) => {
          if (!timers.delete(timer)) return;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (!timers.delete(timer)) return;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function runCheck(manual: boolean): Promise<void> {
    if (checkInFlight) return checkInFlight;
    if (state.phase === "downloading" || state.phase === "installing") return;
    const id = ++attempt;
    state.phase = "checking";
    state.error = null;
    checkInFlight = (async () => {
      try {
        const info = await withTimeout(adapter.check(), checkTimeoutMs);
        if (id !== attempt) return;
        if (info && info.version !== state.currentVersion) {
          state.info = info;
          state.dismissedVersion = null;
          state.phase = "available";
        } else {
          state.info = null;
          state.phase = manual ? "up-to-date" : "idle";
        }
      } catch (e) {
        if (id !== attempt) return;
        state.info = null;
        // 自动检查失败是离线环境的正常结果：静默回到 idle，不弹窗、不留错误。
        state.phase = manual ? "error" : "idle";
        state.error = manual ? errorCode(e) : null;
      } finally {
        state.checkedAt = Date.now();
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  }

  function check(manual = true): Promise<void> {
    return runCheck(manual);
  }

  function download(): Promise<void> {
    if (downloadInFlight) return downloadInFlight;
    if (!state.info || state.phase === "downloading" || state.phase === "installing") {
      return Promise.resolve();
    }
    const id = ++attempt;
    state.phase = "downloading";
    state.downloaded = 0;
    state.total = null;
    state.error = null;
    cancelRequested = false;
    downloadInFlight = (async () => {
      try {
        await adapter.download((event) => {
          if (id !== attempt) return;
          if (event.event === "Started") {
            const total = event.data?.contentLength;
            state.total = typeof total === "number" && total > 0 ? total : null;
          } else if (event.event === "Progress") {
            state.downloaded += event.data?.chunkLength ?? 0;
          }
        });
        if (id !== attempt) return;
        state.phase = cancelRequested ? "available" : "ready";
      } catch (e) {
        if (id !== attempt) return;
        if (cancelRequested || /UPDATER_CANCELLED/.test(String(e))) {
          state.phase = "available";
          state.error = null;
        } else {
          state.phase = "error";
          state.error = errorCode(e);
        }
      } finally {
        downloadInFlight = null;
        cancelRequested = false;
      }
    })();
    return downloadInFlight;
  }

  async function cancel(): Promise<void> {
    if (state.phase !== "downloading") return;
    cancelRequested = true;
    try {
      await adapter.cancel();
    } catch {
      // 取消失败仍让下载 Promise 自己决定结局；不能在这里假装已取消。
    }
  }

  async function install(): Promise<void> {
    if (state.phase !== "ready" || !state.info) return;
    state.phase = "installing";
    state.error = null;
    try {
      await adapter.install();
      // 正常路径会在安装后重启（Windows 安装器退出 / macOS/Linux 由 Rust rerun）。
      // 若真的回到这里，说明安装已完成但进程没重启：保持可读状态，不谎报 downloading。
      state.currentVersion = state.info?.version ?? state.currentVersion;
      state.info = null;
      state.phase = "up-to-date";
    } catch (e) {
      state.phase = "error";
      state.error = errorCode(e);
    }
  }

  function dismiss(): void {
    if (state.phase === "downloading" || state.phase === "installing") return;
    state.dismissedVersion = state.info?.version ?? state.dismissedVersion;
    state.info = null;
    state.phase = "idle";
    state.error = null;
    ++attempt;
    void adapter.close().catch(() => {});
  }

  function dispose(): void {
    ++attempt;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    checkInFlight = null;
    downloadInFlight = null;
  }

  /**
   * 用**后端那份全局状态**补齐本窗口的 UI 状态（B5）。
   *
   * 为什么需要：每个窗口各有一份 UI 服务，而下载任务在后端是全局单例。设置窗关掉再打开时，
   * 这份服务回到 `idle`，用户看到的是"检查更新"按钮 —— 明明后台还在下那几十 MB。
   * 本窗口自己发起过下载时服务里有更细的进度（channel 逐块），那种情况**不覆盖**
   * （`phase !== "idle"` 直接返回）：粗粒度快照不该盖掉细粒度读数。
   */
  function restore(snapshot: {
    phase: string;
    downloaded: number;
    total: number | null;
    version: string | null;
  }) {
    if (state.phase !== "idle") return;
    const info = snapshot.version
      ? { currentVersion: state.currentVersion, version: snapshot.version, notes: null, publishedAt: null }
      : null;
    switch (snapshot.phase) {
      case "downloading":
        state.phase = "downloading";
        state.info = info;
        state.downloaded = snapshot.downloaded;
        state.total = snapshot.total;
        break;
      case "ready":
        state.phase = "ready";
        state.info = info;
        state.downloaded = snapshot.total ?? snapshot.downloaded;
        state.total = snapshot.total;
        break;
      case "installing":
        state.phase = "installing";
        state.info = info;
        break;
      default:
        // idle / checking / failed / cancelled / unsupported：这几种在本窗口不值得"恢复"，
        // 保持 idle（用户点一下检查就知道了；失败也没有可展示的上下文）。
        break;
    }
  }

  return { state, check, download, cancel, install, dismiss, dispose, restore };
}

export type UpdaterService = ReturnType<typeof createUpdaterService>;
