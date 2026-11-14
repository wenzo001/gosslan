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

export type UpdaterErrorCode =
  | "timeout"
  | "network"
  | "signature"
  | "manifest"
  | "busy"
  | "downgrade"
  | "unknown";

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
  /**
   * 指定来源重新查清单（可选，老适配器没有这个能力时退回 `check()`）。
   * 后端会只把那一个端点交给官方插件 ⇒ 清单与安装包同源；换源只能整包重下。
   */
  checkSource?(source: string): Promise<UpdateInfo | null>;
  download(onEvent: (event: DownloadEvent) => void): Promise<void>;
  cancel(): Promise<void>;
  /**
   * 安装**之前**的复查（可选）：下载可能花几十分钟，期间可能又发布了新版本。
   * 返回非空 = 清单上有更高版本（后端已丢弃手里那份字节），调用方应改为提示重新下载。
   */
  recheckReady?(): Promise<UpdateInfo | null>;
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
  /**
   * 一条"刚才发生了什么"的说明（不承载动作，只解释状态为什么变成现在这样）。
   * 目前只有 `superseded`：装之前复查发现更高版本，手里那份已被丢弃。
   */
  notice: "superseded" | null;
  /** 清单/安装包实际来源：`auto | gitee | github | unknown`。界面据此说「正在从哪下」。 */
  source: string;
  /** 后端自动切源留下的短码（如 `auto_switched_to_gitee`），由界面翻成人话；null = 没有。 */
  sourceEvent: string | null;
  /**
   * 下载慢到该给用户一个「换源」入口了。
   * 刻意**只提示不自动切**：正在飞的几十 MB 说丢就丢，这个决定要用户自己点。
   */
  slow: boolean;
}

export const UPDATER_CANCELLED = "UPDATER_CANCELLED";
const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
/** 开始下载后这么久还没到 `SLOW_MIN_BYTES` 就判定这条链路慢。 */
const DEFAULT_SLOW_WINDOW_MS = 20_000;
const DEFAULT_SLOW_MIN_BYTES = 512 * 1024;

function errorCode(e: unknown): UpdaterErrorCode {
  const text = String((e as { message?: unknown })?.message ?? e);
  if (/UPDATER_CANCELLED|cancel/i.test(text)) return "unknown";
  // 要在其余关键词之前判：后端文案是「清单版本 … 不高于当前 …，已拒绝」，
  // 落到 unknown 只会显示「更新失败，请稍后重试」，用户不知道发生了什么（也重试不好）。
  if (/UPDATER_DOWNGRADE_BLOCKED|禁止降级/i.test(text)) return "downgrade";
  if (/timeout|timed? ?out|超时/i.test(text)) return "timeout";
  if (/签名|signature|verify/i.test(text)) return "signature";
  if (/json|manifest|清单|格式/i.test(text)) return "manifest";
  if (/正在进行|已在下载|正在下载|busy/i.test(text)) return "busy";
  if (/network|dns|http|连接|下载失败|不可达|unreachable/i.test(text)) return "network";
  return "unknown";
}

export function createUpdaterService(
  adapter: UpdaterAdapter,
  options: {
    currentVersion?: string;
    checkTimeoutMs?: number;
    /** 测试可把「慢速窗口」压到毫秒级；线上用 20s / 512KB 这一档。 */
    slowWindowMs?: number;
    slowMinBytes?: number;
  } = {},
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
    notice: null,
    source: "auto",
    sourceEvent: null,
    slow: false,
  });

  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const slowWindowMs = options.slowWindowMs ?? DEFAULT_SLOW_WINDOW_MS;
  const slowMinBytes = options.slowMinBytes ?? DEFAULT_SLOW_MIN_BYTES;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let attempt = 0;
  let checkInFlight: Promise<void> | null = null;
  let downloadInFlight: Promise<void> | null = null;
  let cancelRequested = false;
  /** 下载失败后自动换源重下，只允许一次，避免两个源轮流失败时无限打转。 */
  let pendingAutoSwitch = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSlowTimer() {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
  }

  /** 只在「下载已经开始但迟迟没有字节」时亮换源入口；进度正常就什么也不做。 */
  function armSlowCheck(id: number) {
    clearSlowTimer();
    slowTimer = setTimeout(() => {
      slowTimer = null;
      if (id !== attempt || state.phase !== "downloading") return;
      if (state.downloaded < slowMinBytes) state.slow = true;
    }, slowWindowMs);
  }

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
    // 手动/自动检查都是一次"重新看清单" ⇒ 上一轮的"刚发布了更高版本"已经过期，别留着。
    state.notice = null;
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

  function download(autoRetried = false): Promise<void> {
    if (downloadInFlight) return downloadInFlight;
    if (!state.info || state.phase === "downloading" || state.phase === "installing") {
      return Promise.resolve();
    }
    const id = ++attempt;
    state.phase = "downloading";
    state.downloaded = 0;
    state.total = null;
    state.error = null;
    state.notice = null;
    state.slow = false;
    cancelRequested = false;
    armSlowCheck(id);
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
        // 下完了就不需要换源入口；失败时**保留**，那一格正是 error 态要用的提示。
        state.slow = false;
      } catch (e) {
        if (id !== attempt) return;
        if (cancelRequested || /UPDATER_CANCELLED/.test(String(e))) {
          state.phase = "available";
          state.error = null;
        } else {
          const code = errorCode(e);
          // 先落终态：`switchSource` 看到 error 就不会再对这份已结束的下载发一次 cancel。
          state.phase = "error";
          state.error = code;
          // GitHub 连不上/太慢导致下载失败 ⇒ 直接换 Gitee 整包重下，只试一次。
          if (
            !autoRetried &&
            (code === "network" || code === "timeout") &&
            state.source === "github" &&
            adapter.checkSource
          ) {
            await switchSource("gitee");
            if (state.info) pendingAutoSwitch = true;
          }
        }
      } finally {
        downloadInFlight = null;
        cancelRequested = false;
        clearSlowTimer();
        if (pendingAutoSwitch) {
          pendingAutoSwitch = false;
          // 旧下载的 Promise 到这里才收口，此刻才允许发起整包重下。
          void download(true);
        }
      }
    })();
    return downloadInFlight;
  }

  /**
   * 手动（或下载失败自动）换源：先停掉在飞的下载，再用那一个端点重新查清单。
   * 官方更新器整块内存下载、验签后一次返回 ⇒ 换源没有续传，只能整包重下。
   */
  async function switchSource(source: string): Promise<void> {
    if (state.phase === "downloading") {
      cancelRequested = true;
      try {
        await adapter.cancel();
      } catch {
        // 取消失败也继续：下载 Promise 自己会有终态。
      }
      if (downloadInFlight) await withTimeout(downloadInFlight, 3_000).catch(() => {});
    }
    const id = ++attempt;
    state.phase = "checking";
    state.error = null;
    state.notice = null;
    state.slow = false;
    state.downloaded = 0;
    state.total = null;
    state.source = source;
    state.sourceEvent = null;
    try {
      const info = adapter.checkSource
        ? await withTimeout(adapter.checkSource(source), checkTimeoutMs)
        : await withTimeout(adapter.check(), checkTimeoutMs);
      if (id !== attempt) return;
      if (info && info.version !== state.currentVersion) {
        state.info = info;
        state.phase = "available";
      } else {
        state.info = null;
        state.phase = "up-to-date";
      }
    } catch (e) {
      if (id !== attempt) return;
      state.info = null;
      state.phase = "error";
      state.error = errorCode(e);
    } finally {
      state.checkedAt = Date.now();
    }
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
    state.notice = null;
    // 装之前先复查：下载可能花了几十分钟，期间可能已经发了新版本。
    // 复查失败（断网/清单损坏）**不拦安装** —— 手里这份是签名校验过的，网络抖一下
    // 不能让人永远装不上；只有"清单明确更高"才把用户挡下来。
    if (adapter.recheckReady) {
      try {
        const newer = await adapter.recheckReady();
        if (newer) {
          state.info = newer;
          state.phase = "available";
          state.downloaded = 0;
          state.total = null;
          state.error = null;
          state.notice = "superseded";
          return;
        }
      } catch {
        // 见上：不拦。
      }
    }
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
    state.notice = null;
    state.slow = false;
    ++attempt;
    void adapter.close().catch(() => {});
  }

  function dispose(): void {
    ++attempt;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearSlowTimer();
    pendingAutoSwitch = false;
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
    error?: string | null;
    /** #34：后端在启动时从 settings 表恢复出来的更新意图。 */
    resumable?: boolean;
    /** 后端实际命中的清单/安装包来源，以及自动切源留下的短码。 */
    source?: string;
    sourceEvent?: string | null;
  }) {
    // 来源与自动切源短码是**事实**，不是相位投影：即便本窗口正在下载（下面会提前返回），
    // 这两格也必须跟着后端走，否则自动回落到 Gitee 之后界面还写着 GitHub。
    if (snapshot.source) state.source = snapshot.source;
    state.sourceEvent = snapshot.sourceEvent ?? null;
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
      case "failed":
        // 只有"**下载**中途失败"（已经有字节了）才恢复：那正是用户会困惑的一刻
        // （"刚才下了一半，现在窗口上什么都没有"）。检查失败（downloaded=0）不恢复 ——
        // 离线是常态，没必要每次开设置都挂一条红。
        if (snapshot.downloaded > 0) {
          state.phase = "error";
          state.info = info;
          state.downloaded = snapshot.downloaded;
          state.total = snapshot.total;
          state.error = errorCode(new Error(snapshot.error ?? ""));
        }
        break;
      default:
        // #34：`idle` + `resumable` = 重启后从持久意图恢复出来的「有可用更新」。
        // 设置页要直接显示下载卡片，而不是只留一个"检查更新"按钮；任务中心那一行
        // 由后端 `updater_status` 快照独立驱动，不依赖本窗口这份 UI 服务。
        // 进度归零是刻意的：字节没跟着进程活下来，这里是"重新下载"不是"续传"。
        if (snapshot.phase === "idle" && snapshot.resumable && snapshot.version) {
          state.phase = "available";
          state.info = info;
          state.downloaded = 0;
          state.total = null;
        }
        break;
    }
  }

  return { state, check, download, cancel, install, dismiss, dispose, restore, switchSource };
}

export type UpdaterService = ReturnType<typeof createUpdaterService>;
