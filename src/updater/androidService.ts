/**
 * 安卓应用内升级的状态机（纯逻辑，不 import Tauri）。
 *
 * 为什么单独一份而不是复用 `service.ts`：桌面那条链是
 * `idle→checking→available→downloading→ready→installing`，装完就重启，**没有**
 * 「下载后校验」「系统安装器要等用户确认」「用户在系统设置里授权后回来」这三段；
 * 硬塞进同一个状态机会让桌面那条已经稳定的路径跟着改（用户明确要求不能带坏桌面）。
 * 这里只额外加两件事：
 *
 * 1. `verifying`：下载完成 ≠ 可以装，必须复算 sha256 + 解析包名/版本/签名；
 * 2. `installStep`：`preparing`（写安装会话）→ `launching`（会话已提交）→
 *    `waiting-user`（系统确认框已经出现）。**前两步系统安装器还没露面**，
 *    界面必须继续显示「正在安装」并禁用按钮 —— 这正是用户报的「点确认后弹窗立刻关掉、
 *    一段静默、再突然跳出安装界面」的根因修复点。
 *
 * 真实命令由 `androidAdapter.ts` 提供；`androidService.test.ts` 用假适配器把每个转移
 * （含取消/失败/重复点击）都跑一遍。
 */
import { reactive } from "vue";
// 相对路径 + 显式 `.ts`（不是 `@/utils/...`）：本文件的单测用 `node --test` 直接跑 TS，
// 只做类型擦除、不认 Vite 的路径别名；ESM 也不做扩展名补全。`tsconfig` 已开
// `allowImportingTsExtensions`（`utils/initScope.test.ts` 也是这么写的）。
import { createInitScope } from "../utils/initScope.ts";
import type {
  AndroidDownloadEvent,
  AndroidUpdateInfo,
  AndroidUpdateStatus,
} from "@/types";

export type AndroidPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "installed"
  | "failed";

/** 安装阶段（只在 `phase === "installing"` 期间有值）。 */
export type AndroidInstallStep = "preparing" | "launching" | "waiting-user" | "installing";

export type AndroidErrorCode =
  | "network"
  | "timeout"
  | "rate-limit"
  | "no-release"
  | "manifest"
  | "checksum"
  | "size"
  | "parse"
  | "signature"
  | "permission"
  | "install-cancelled"
  | "install-failed"
  | "busy"
  | "unsupported"
  | "unknown";

/** 失败后「重试」应该回到哪一步（`null` = 没有可重试的动作）。 */
export type AndroidRetryTarget = "check" | "download" | "install" | null;

export interface AndroidUpdateAdapter {
  check(): Promise<AndroidUpdateInfo | null>;
  download(onEvent: (event: AndroidDownloadEvent) => void): Promise<void>;
  verify(): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  openPermissionSettings(): Promise<void>;
  /** 订阅后端状态事件；返回取消订阅函数。 */
  onStatus(cb: (status: AndroidUpdateStatus) => void): Promise<() => void>;
  /** 补拉当前后端状态（设置页重新打开 / 进程被系统挂起后回来）。 */
  status?(): Promise<AndroidUpdateStatus>;
}

export interface AndroidUpdateState {
  phase: AndroidPhase;
  currentVersion: string;
  info: AndroidUpdateInfo | null;
  downloaded: number;
  total: number | null;
  installStep: AndroidInstallStep | null;
  /** 后端给的具名原因（`code=ANDROID_UPDATE_*` 原文，调试/日志用）。 */
  error: string | null;
  /** 映射后的话术键（界面按它取 i18n，不允许退化成「更新失败」四个字）。 */
  errorCode: AndroidErrorCode | null;
  retry: AndroidRetryTarget;
  /** 手动检查过且确实没有新版本（界面显示「已是最新」）。 */
  upToDate: boolean;
  /** 正在安装但系统安装器还没接管：弹窗必须保持打开 + busy。 */
  installInFlight: boolean;
}

function messageOf(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e);
}

/** 把 Rust 的 `code=ANDROID_UPDATE_*` 或 Kotlin 的具名码映射成界面话术键。 */
export function mapAndroidError(e: unknown): {
  code: AndroidErrorCode;
  retry: AndroidRetryTarget;
  raw: string;
} {
  const raw = messageOf(e);
  const m = /code=([A-Z0-9_]+)/.exec(raw);
  const name = m?.[1] ?? "";
  switch (name) {
    case "ANDROID_UPDATE_NETWORK":
    case "ANDROID_UPDATE_HTTP":
      return { code: "network", retry: "check", raw };
    case "ANDROID_UPDATE_TIMEOUT":
      return { code: "timeout", retry: "check", raw };
    case "ANDROID_UPDATE_RATE_LIMIT":
      return { code: "rate-limit", retry: "check", raw };
    case "ANDROID_UPDATE_NO_RELEASE":
      return { code: "no-release", retry: "check", raw };
    case "ANDROID_UPDATE_MANIFEST":
    case "ANDROID_UPDATE_NO_ASSET":
    case "ANDROID_UPDATE_NO_DIGEST":
      return { code: "manifest", retry: "check", raw };
    case "ANDROID_UPDATE_CHECKSUM":
      return { code: "checksum", retry: "download", raw };
    case "ANDROID_UPDATE_SIZE_MISMATCH":
      return { code: "size", retry: "download", raw };
    case "ANDROID_UPDATE_PARSE":
    case "ANDROID_UPDATE_WRONG_PACKAGE":
      return { code: "parse", retry: "download", raw };
    case "ANDROID_UPDATE_SIGNATURE":
      return { code: "signature", retry: "download", raw };
    case "ANDROID_UPDATE_PERMISSION":
      return { code: "permission", retry: "install", raw };
    case "ANDROID_UPDATE_INSTALL_CANCELLED":
      return { code: "install-cancelled", retry: "install", raw };
    case "ANDROID_UPDATE_NO_APK":
    case "ANDROID_UPDATE_FILE_MISSING":
      // 安装包已被后端删除 ⇒ 重试只能从头下载。
      return { code: "install-failed", retry: "download", raw };
    case "ANDROID_UPDATE_INSTALL_FAILED":
    case "ANDROID_UPDATE_IO":
      return { code: "install-failed", retry: "install", raw };
    case "ANDROID_UPDATE_BUSY":
      return { code: "busy", retry: null, raw };
    case "ANDROID_UPDATE_UNSUPPORTED":
      return { code: "unsupported", retry: null, raw };
    default:
      break;
  }
  // 没有机器码时退回关键词（只用于兜底，正常路径都带 code）。
  if (/timeout|超时/i.test(raw)) return { code: "timeout", retry: "check", raw };
  if (/network|连接|不可达|http/i.test(raw)) return { code: "network", retry: "check", raw };
  if (/签名|signature/i.test(raw)) return { code: "signature", retry: "download", raw };
  if (/校验|checksum|sha256/i.test(raw)) return { code: "checksum", retry: "download", raw };
  if (/权限|permission|未知来源/i.test(raw)) return { code: "permission", retry: "install", raw };
  return { code: "unknown", retry: null, raw };
}

/** 弹窗是否应保持打开并禁用取消/关闭（系统安装器还没接管的那一刻）。 */
export function isInstallBusy(state: AndroidUpdateState): boolean {
  return (
    state.phase === "installing" &&
    (state.installStep === "preparing" ||
      state.installStep === "launching" ||
      state.installStep === "installing")
  );
}

/** 系统安装器是否已经接管（此时才允许把弹窗关掉，让系统界面站到前台）。 */
export function installerTookOver(state: AndroidUpdateState): boolean {
  return (
    state.phase === "installing" &&
    (state.installStep === "waiting-user" || state.installStep === null)
  );
}

export function createAndroidUpdaterService(
  adapter: AndroidUpdateAdapter,
  options: { currentVersion?: string; checkTimeoutMs?: number } = {},
) {
  const state = reactive<AndroidUpdateState>({
    phase: "idle",
    currentVersion: options.currentVersion ?? "",
    info: null,
    downloaded: 0,
    total: null,
    installStep: null,
    error: null,
    errorCode: null,
    retry: null,
    upToDate: false,
    installInFlight: false,
  });

  const checkTimeoutMs = options.checkTimeoutMs ?? 15_000;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let attempt = 0;
  let checkInFlight: Promise<void> | null = null;
  let downloadInFlight: Promise<void> | null = null;
  let cancelRequested = false;
  // 「注册 ↔ 卸载」配对只认 `utils/initScope` 这一处（designGuards 会拦手工句柄）：
  // 订阅是「注册一次、销毁时摘掉」，正是它管的形状；已在销毁后才拿到的卸载函数
  // 会被就地执行，不会把监听留在事件总线上。
  const initScope = createInitScope();
  let subscribed = false;

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        // 只给错误码：界面话术由 i18n 按码生成（纯状态机不持有中文文案）。
        reject(new Error("code=ANDROID_UPDATE_TIMEOUT"));
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

  /**
   * `forceRetry` 用于「同一个错误码在不同阶段含义不同」的情况：`ANDROID_UPDATE_NETWORK`
   * 出现在**检查**阶段就重查，出现在**下载**阶段就重下 —— 不能一律当成检查失败。
   * 只有 `busy/unsupported` 这类「没有可重试动作」的码不受覆盖。
   */
  function failWith(e: unknown, forceRetry?: AndroidRetryTarget): void {
    const mapped = mapAndroidError(e);
    state.phase = "failed";
    state.error = mapped.raw;
    state.errorCode = mapped.code;
    state.retry = mapped.retry === null ? null : (forceRetry ?? mapped.retry);
    state.installStep = null;
  }

  function resetToIdle(): void {
    state.phase = "idle";
    state.info = null;
    state.downloaded = 0;
    state.total = null;
    state.installStep = null;
    state.error = null;
    state.errorCode = null;
    state.retry = null;
    state.upToDate = false;
    state.installInFlight = false;
  }

  function check(): Promise<void> {
    if (checkInFlight) return checkInFlight;
    if (
      state.phase === "checking" ||
      state.phase === "downloading" ||
      state.phase === "verifying" ||
      state.phase === "ready" ||
      state.phase === "installing"
    ) {
      return Promise.resolve();
    }
    const id = ++attempt;
    state.phase = "checking";
    state.error = null;
    state.errorCode = null;
    state.retry = null;
    state.upToDate = false;
    checkInFlight = (async () => {
      try {
        const info = await withTimeout(adapter.check(), checkTimeoutMs);
        if (id !== attempt) return;
        if (info) {
          state.info = info;
          state.downloaded = 0;
          state.total = info.size > 0 ? info.size : null;
          state.phase = "available";
        } else {
          state.info = null;
          state.total = null;
          state.phase = "idle";
          state.upToDate = true;
        }
      } catch (e) {
        if (id !== attempt) return;
        state.info = null;
        failWith(e, "check");
      } finally {
        state.currentVersion = state.info?.currentVersion || state.currentVersion;
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  }

  /** 下载完成后的第二道闸：复算 sha256 + 解析包/签名。 */
  async function verifyInner(id: number): Promise<boolean> {
    state.phase = "verifying";
    state.error = null;
    state.errorCode = null;
    try {
      await adapter.verify();
      if (id !== attempt) return false;
      state.phase = "ready";
      state.downloaded = state.total ?? state.info?.size ?? state.downloaded;
      state.total = state.total ?? state.info?.size ?? null;
      state.retry = null;
      return true;
    } catch (e) {
      if (id !== attempt) return false;
      state.downloaded = 0;
      failWith(e, "download");
      return false;
    }
  }

  function download(): Promise<void> {
    if (downloadInFlight) return downloadInFlight;
    if (
      state.phase === "installing" ||
      state.phase === "downloading" ||
      state.phase === "verifying" ||
      !state.info
    ) {
      return Promise.resolve();
    }
    const id = ++attempt;
    state.phase = "downloading";
    state.downloaded = 0;
    state.total = state.info.size > 0 ? state.info.size : null;
    state.error = null;
    state.errorCode = null;
    state.retry = null;
    cancelRequested = false;
    downloadInFlight = (async () => {
      try {
        await adapter.download((event) => {
          if (id !== attempt) return;
          if (event.event === "Started") {
            const total = event.data?.contentLength;
            if (typeof total === "number" && total > 0) state.total = total;
          } else if (event.event === "Progress") {
            state.downloaded += event.data?.chunkLength ?? 0;
          }
        });
        if (id !== attempt) return;
        if (cancelRequested) {
          state.phase = "available";
          state.downloaded = 0;
          return;
        }
        await verifyInner(id);
      } catch (e) {
        if (id !== attempt) return;
        // 取消不是失败：回到「可以再点下载」，且不留半包（后端已删 `.part`）。
        if (cancelRequested || /ANDROID_UPDATE_CANCELLED|cancel/i.test(messageOf(e))) {
          state.phase = "available";
          state.downloaded = 0;
          state.total = state.info?.size ?? null;
          state.error = null;
          state.errorCode = null;
          state.retry = null;
        } else {
          state.downloaded = 0;
          failWith(e, "download");
        }
      } finally {
        downloadInFlight = null;
        cancelRequested = false;
      }
    })();
    return downloadInFlight;
  }

  async function cancelDownload(): Promise<void> {
    if (state.phase !== "downloading") return;
    cancelRequested = true;
    try {
      await adapter.cancel();
    } catch {
      // 取消失败仍让下载 Promise 自己决定结局；不能在这里假装已取消。
    }
    // 后端取消是异步收敛的；这里先把界面回到「可重试」，下载 Promise 随后再收敛一次
    // （transfer 是幂等的：两条路径都只是把 phase 设成 available）。
    if (state.phase === "downloading") {
      state.phase = "available";
      state.downloaded = 0;
      state.total = state.info?.size ?? null;
      state.error = null;
      state.errorCode = null;
      state.retry = null;
    }
  }

  function install(): Promise<void> {
    if (state.installInFlight || state.phase === "installing") return Promise.resolve();
    const allowed =
      state.phase === "ready" || (state.phase === "failed" && state.retry === "install");
    if (!allowed || !state.info) return Promise.resolve();
    state.installInFlight = true;
    state.phase = "installing";
    state.installStep = "preparing";
    state.error = null;
    state.errorCode = null;
    state.retry = null;
    return (async () => {
      try {
        await adapter.install();
        // 会话已提交 ⇒ 系统确认框马上就会出现；这一步之后才允许关弹窗。
        if (state.phase === "installing" && state.installStep === "preparing") {
          state.installStep = "launching";
        }
      } catch (e) {
        state.installInFlight = false;
        failWith(e);
      } finally {
        state.installInFlight = false;
      }
    })();
  }

  /** 失败后的「重试」：按失败发生的阶段回到对应动作，而不是一律重新检查。 */
  function retry(): Promise<void> {
    switch (state.retry) {
      case "check":
        return check();
      case "download":
        return download();
      case "install":
        return install();
      default:
        return Promise.resolve();
    }
  }

  async function openPermissionSettings(): Promise<void> {
    try {
      await adapter.openPermissionSettings();
    } catch {
      // 打不开设置页不改变状态：界面仍显示「无权限」与「重试」。
    }
  }

  async function dismiss(): Promise<void> {
    if (state.phase === "installing" || state.phase === "downloading") return;
    ++attempt;
    resetToIdle();
    try {
      await adapter.close();
    } catch {
      // 关闭清理失败不影响界面回到 idle。
    }
  }

  /**
   * 合并后端状态事件。规则是「后端只负责它知道的事」：
   * - `installing/installed/failed` 是终态/关键态，直接采纳（含 `installStep`）；
   * - `downloading` 只更新读数（且不倒退），因为本窗口的 channel 进度更细；
   * - 其余阶段只在没有本地动作时跟随，避免事件把用户刚点的动作盖掉。
   */
  function applyStatus(snapshot: AndroidUpdateStatus): void {
    switch (snapshot.phase) {
      case "installing": {
        state.phase = "installing";
        const step = snapshot.installStep;
        if (step === "preparing" || step === "launching" || step === "waiting-user" || step === "installing") {
          state.installStep = step;
        } else if (state.installStep === null) {
          state.installStep = "launching";
        }
        state.error = null;
        state.errorCode = null;
        state.retry = null;
        break;
      }
      case "installed": {
        state.phase = "installed";
        state.installStep = null;
        state.installInFlight = false;
        state.error = null;
        state.errorCode = null;
        state.retry = null;
        if (snapshot.version) state.currentVersion = snapshot.version;
        break;
      }
      case "failed": {
        // 安装过程中的失败必须落地（用户取消安装也正是这一档）。
        // 兜底只留错误码、不写中文：面向用户的话术一律由 `errorKey` + i18n 生成
        // （本文件是纯状态机，`node --test` 直接跑，不引入 i18n 运行时）。
        const err = snapshot.error ?? "code=ANDROID_UPDATE_INSTALL_FAILED";
        failWith(
          new Error(err),
          snapshot.errorCode === "ANDROID_UPDATE_INSTALL_CANCELLED" ? "install" : undefined,
        );
        state.installInFlight = false;
        break;
      }
      case "ready": {
        if (state.phase === "installing") break;
        state.phase = "ready";
        state.installStep = null;
        state.installInFlight = false;
        state.error = null;
        state.errorCode = null;
        state.retry = null;
        if (snapshot.total) state.total = snapshot.total;
        state.downloaded = state.total ?? state.downloaded;
        break;
      }
      case "verifying": {
        if (state.phase === "downloading") state.phase = "verifying";
        break;
      }
      case "downloading": {
        if (state.phase === "downloading" || state.phase === "checking") {
          state.phase = "downloading";
          const total = snapshot.total ?? snapshot.size ?? null;
          if (total) state.total = total;
          // 事件是 200ms 一次的粗粒度快照：只向前推，别把 channel 的细读数拉回去。
          if (snapshot.downloaded > state.downloaded) state.downloaded = snapshot.downloaded;
        }
        break;
      }
      case "cancelled": {
        if (state.phase === "downloading" || state.phase === "verifying") {
          state.phase = "available";
          state.downloaded = 0;
          state.total = state.info?.size ?? null;
          state.error = null;
          state.errorCode = null;
          state.retry = null;
        }
        break;
      }
      default:
        // `idle/checking/available`：本地动作已经知道这些，不覆盖。
        break;
    }
  }

  /** 订阅后端事件（幂等；`dismiss` 之后仍保持订阅，重开设置页要用）。 */
  async function subscribe(): Promise<void> {
    if (subscribed) return;
    subscribed = true;
    try {
      const off = await adapter.onStatus(applyStatus);
      initScope.onDispose(off);
    } catch {
      // 事件订阅失败时界面仍可用（只是安装步骤退回本地 `launching`），不阻断流程；
      // 允许下一次重开设置页再试。
      subscribed = false;
    }
  }

  /** 应用回到前台/设置页重新打开时补拉一次后端状态。 */
  async function restore(): Promise<void> {
    if (!adapter.status) return;
    try {
      const snapshot = await adapter.status();
      if (snapshot && snapshot.phase) applyStatus(snapshot);
    } catch {
      // 补拉失败就保持本地状态。
    }
  }

  function dispose(): void {
    ++attempt;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    checkInFlight = null;
    downloadInFlight = null;
    initScope.dispose();
  }

  return {
    state,
    check,
    download,
    cancelDownload,
    install,
    retry,
    openPermissionSettings,
    dismiss,
    applyStatus,
    subscribe,
    restore,
    dispose,
  };
}

export type AndroidUpdaterService = ReturnType<typeof createAndroidUpdaterService>;
