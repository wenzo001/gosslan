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
/** 引用文字：继承气泡主色再降到 72%，保证和正文同档对比又不抢戏。 */
export const QUOTE_TEXT_STYLE = "color: currentColor; opacity: 0.72;";

/** 文件/代码气泡的图标底色圆角块：用气泡字色做轻底，图标继承字色。
 * 替代原先的 `bg-primary-light`（rgba 主色 0.12）+ `text-primary`——那个组合在
 * 本机气泡（主色背景）上底色和图标都是主色，几乎不可见。 */
export const ICON_WELL_BG = "color-mix(in srgb, currentColor 14%, transparent)";
