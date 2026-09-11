/**
 * 平台判定。
 *
 * 单文件只放一个判定，是因为它已经有多个消费者（标题栏的窗口按钮布局、
 * 快捷键的修饰键选择），各写一份迟早会漂移。
 *
 * 判据：Tauri 的 WebView 里 `navigator.userAgent` 在 macOS 含 `Macintosh`。
 * ⚠️ 这是**运行时**判定，不能用于 gating 原生代码（那是 `#[cfg(target_os)]` 的事）。
 */

/**
 * 判断一段 UA 是否来自桌面 macOS（纯函数，便于单测）。
 *
 * ⚠️ 只用 `Macintosh`，不能用 `Mac OS X`：iOS / iPadOS 的 UA 形如
 * `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ...`，
 * 其中 `like Mac OS X` 会命中 `/Mac OS X/`，从而把 iPhone/iPad 误判成 Mac ——
 * 表现是移动端标题栏错误地渲染红绿灯、快捷键误用 ⌘ 而非 ctrl。
 * 桌面 macOS 的 UA 恒含 `Macintosh`（Apple Silicon 上也是 `Macintosh; Intel Mac OS X`）。
 */
export function isMacUA(ua: string): boolean {
  return /Macintosh/i.test(ua);
}

/**
 * 运行时平台判定（Tauri WebView UA）。
 * 加 `typeof navigator` 守卫：本模块被 Node 单测 import 时 navigator 不存在，
 * 这里不能因取 UA 抛错（单测只关心 isMacUA 这个纯函数）。
 */
export const isMac =
  typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
    ? isMacUA(navigator.userAgent)
    : false;
