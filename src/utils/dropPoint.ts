/**
 * 把 Tauri 拖拽事件里的 `position` 换算成 **CSS 像素**（相对 webview 左上角）。
 *
 * ⚠️ 两个平台的量纲**不一样** —— 这是读锁定版本源码确认的（wry 0.57 / tauri 2.12.5）：
 * - **macOS**：`wkwebview/drag_drop.rs` 取 `draggingLocation()`（NSView 坐标 = **点**）再算
 *   `frame.size.height - y` ⇒ 结果已经是相对 webview 左上角的**点**，与 CSS px 1:1。
 *   再多除一次 `devicePixelRatio` 就是 2× 偏移：Retina 上必须拖到"看起来偏左上"才命中。
 * - **Windows**：`webview2/drag_drop.rs` 用 `ScreenToClient` 之后的 **物理像素** ⇒ 要除 DPR。
 *
 * 两者用同一个换算必然有一侧错（2026-10-29 负责人在 Mac 上实测：正经位置不高亮，
 * 偏过去才高亮）。所以这里把"平台 → 除数"收成一处，别在两处各写一遍。
 */
export function dropPointToCss(
  pos: { x: number; y: number },
  env: { mac: boolean; dpr: number },
): { x: number; y: number } {
  // macOS：点 == CSS px，不除；DPR 兜底成 1（读不到时宁可"不换算"，也不要除 0）。
  const factor = env.mac ? 1 : env.dpr > 0 ? env.dpr : 1;
  return { x: pos.x / factor, y: pos.y / factor };
}
