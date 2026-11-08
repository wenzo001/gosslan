/**
 * 引用块配色：用气泡自身的字色（currentColor）做透明叠加，
 * 主题色气泡得「白底+白边」、中性气泡得「深底+深边」，所有预设气泡都自带对比。
 * 不再硬编 rgba(128,128,128,...)：那个灰在蓝/紫/绿气泡上几乎看不见。
 *
 * 引用文字本身用 currentColor + opacity，比 text-2 在主题色气泡上更稳。
 *
 * color-mix 是 CSS Color 5 标准，Chrome 111+ / Safari 16.4+ / Firefox 113+ 全部支持；
 * Tauri 2 WebView（WebView2 / WKWebView）都满足。
 */
export const QUOTE_BORDER = "color-mix(in srgb, currentColor 35%, transparent)";
export const QUOTE_BG = "color-mix(in srgb, currentColor 8%, transparent)";
/**
 * 引用文字：继承气泡字色再降到 85%，保证和正文同档对比又不抢戏。
 *
 * 为什么是 85% 而不是 72%（2026-11-08 对比度普查实测）：72% 让文字自身只剩 72% 的 alpha，
 * 合成到气泡底上后，暗色画布下最差一档只有 **APCA Lc 57.1**（低于弱文本档 60），
 * 用户看到的"引用那行灰得发虚"就是它。85% 在同一组底上回到 ≥60，
 * 视觉上仍明显弱于正文（正文是 100% currentColor）。
 * 判据在 `scripts/check-ui-runtime.mjs --only=palette` 的「引用条文字」格。
 */
export const QUOTE_TEXT_STYLE = "color: currentColor; opacity: 0.85;";
