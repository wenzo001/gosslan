/**
 * 辅助窗口（设置 / 日志 / 外链 / 看图）创建失败的**统一出口**。
 *
 * ## 为什么要单独一格
 *
 * 这四扇窗的失败路径以前各不相同：设置静默降级成应用内面板（用户不知道为什么），
 * 日志/外链把后端的中文串原样透传（Windows 上就是
 * `创建 logs 窗口失败: runtime error: failed to create webview. WebView2 error:
 * WindowsError(Error { code: HRESULT(0x80010108), … })`），看图只 toast 一句
 * "预览不可用"、把原始错误丢掉。
 *
 * 现在它们共用一个判断：**认码不认字**。后端在 `ensure_aux_window` 把原始错误写进日志、
 * 上屏的只有 `code=AUX_WINDOW_CREATE_FAILED`；认不出这个码就一律交还调用方原来的提示路径
 * （不按签名猜，避免把别的失败也改写成"请重启"）。
 *
 * ## 文案的责任边界
 *
 * 本文件**不含任何用户可见的句子**：正文与按钮由调用方传入（已本地化）。
 * 这样中英文切换、词典对账（i18n 死文案判据）都只需要管词典一处。
 */
import { errorCode, rawErrorMessage } from "./errors.ts";

/** 与后端 `error_codes::AUX_WINDOW_CREATE_FAILED` 同名（对账判据双向核对）。 */
export const AUX_WINDOW_CREATE_FAILED = "AUX_WINDOW_CREATE_FAILED";

/** 这次失败是不是「辅助窗口建不出来」？只有认得出码才算 —— 其余一律 false。 */
export function isAuxWindowCreateFailure(e: unknown): boolean {
  return errorCode(rawErrorMessage(e)) === AUX_WINDOW_CREATE_FAILED;
}

/** 已本地化的两句：正文只说"为什么 + 下一步"，按钮走既有重启路径。 */
export type AuxWindowFailureTexts = {
  friendly: string;
  restart: string;
};

/** 调用方注入的三个动作（不在这里 new 任何东西，便于单测直接注入假件）。 */
export type AuxWindowFailureDeps = {
  /** 带按钮的提示（按钮 = 不完全退出、直接重启）。 */
  noticeWithRestart: (text: string, label: string, run: () => void) => void;
  /** 不是这类失败时，交还调用方原来的错误提示路径。 */
  fallback: (e: unknown) => void;
  restartApp: () => void;
};

/**
 * 统一出口。返回 `"friendly"` = 已用新文案 + 重启按钮；`"fallback"` = 不是这类失败，
 * 已按调用方原来的方式提示。
 */
export function reportAuxWindowFailure(
  e: unknown,
  texts: AuxWindowFailureTexts,
  deps: AuxWindowFailureDeps,
): "friendly" | "fallback" {
  if (isAuxWindowCreateFailure(e)) {
    // 只给结论与下一步：底层 HRESULT 已由后端写进日志，不上屏。
    deps.noticeWithRestart(texts.friendly, texts.restart, deps.restartApp);
    return "friendly";
  }
  deps.fallback(e);
  return "fallback";
}
