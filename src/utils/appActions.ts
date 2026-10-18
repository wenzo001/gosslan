/**
 * 同一 Webview 内的应用级事件总线（mitt）。
 *
 * 为什么绕一层：macOS 原生菜单项、键盘快捷键、通知点击最终要执行**同一批** UI 动作
 * （打开设置 / 添加好友 / 聚焦搜索 / 去通讯录）。若各入口直接去改组件内部状态，
 * 几条路径很容易行为不一致。统一发意图、UI 层订阅执行，菜单/快捷键只认事件名。
 *
 * 边界（与 Tauri Event 分工）：
 * - 这里只传**同一前端运行环境内**的瞬时通知，不保存状态；
 * - Rust ↔ 前端、跨 Webview 仍走 `@tauri-apps/api/event`，`bindMenuEvents`
 *   负责把 Tauri 菜单事件转成这里的动作；
 * - 长期业务状态（当前会话、未读数、连接状态）归 Pinia，不用事件反复维护。
 *
 * ⚠️ 本模块必须**不 import 任何 `@/…`**：`useShortcuts` / `shortcuts` 这类纯逻辑也要用它，
 * 而它们会被 `node:test` 直接 import —— Node 无法解析 `@/` 别名。`mitt` 是裸包名，可以。
 */
import mitt from "mitt";

export const APP_ACTION = {
  openSettings: "gosslan:open-settings",
  addFriend: "gosslan:add-friend",
  focusSearch: "gosslan:focus-search",
  openLogs: "gosslan:open-logs",
} as const;

export type AppAction = (typeof APP_ACTION)[keyof typeof APP_ACTION];

/** 通知点击后切到通讯录（此前用 `new CustomEvent("navigate-to-contacts")`）。 */
export const NAVIGATE_TO_CONTACTS = "navigate-to-contacts";

export type AppEvent = AppAction | typeof NAVIGATE_TO_CONTACTS;

/**
 * 事件表即类型：新增事件必须同时加到 `AppEvent` 与总线的值类型里，
 * 拼错名字/漏解绑在编译期或测试里就会现形。
 */
export const appBus = mitt<Record<AppEvent, void>>();

/** 触发一个应用级动作（菜单、快捷键、通知共用）。 */
export function emitAction(action: AppEvent) {
  appBus.emit(action);
}

/**
 * 订阅并返回解绑函数。**调用方必须在卸载时调用它**：
 * mitt 不会自动清理，组件重建后重复 `on` 会让一次动作执行多遍。
 */
export function onAction(action: AppEvent, handler: () => void): () => void {
  appBus.on(action, handler);
  return () => appBus.off(action, handler);
}
