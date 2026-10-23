/**
 * 消息行右键/长按的默认行为闸门。
 *
 * 为什么要单独一个纯函数：`App.vue` 已有一条“有选区就放行系统菜单”的全局判据，
 * 而消息行曾无条件写 `@contextmenu.prevent` —— 组件级 prevent 先于全局 handler 执行，
 * 于是移动端选字时只有手柄、没有复制工具条，桌面用鼠标选中正文也吃不到系统菜单。
 * 把三个信号收在这里，组件与测试用同一份判断。
 *
 * ⚠️ 桌面端**不再把选区交给系统菜单**（用户 2026-10-23：「消息气泡的右键菜单有时候会把
 * web 的右键打开，这个是不应该的」）。根因就在原先那条「有选区一律放行」：选区不会因为
 * 右键而消失，只要之前选过任意文字（双击选词、拖选正文），再右键气泡就会弹出 WebKit 的
 * 原生菜单（Look Up / Copy Link with Highlight / Inspect Element），我们的菜单根本不弹。
 * 自定义菜单里本来就有「复制」（整条消息），局部复制用 ⌘/Ctrl+C 仍然可以。只有**触屏**的
 * 选字/选择模式仍必须让位给系统工具条 —— 那条路没有自定义复制入口。
 */
export interface ContextMenuGuard {
  isMobile: boolean;
  /** 移动端「选择文字」模式（气泡已开放 user-select 并自动全选）。 */
  textSelecting: boolean;
  /** 当前有非折叠选区（`window.getSelection()` 的同一判据）。 */
  hasSelection: boolean;
}

export function shouldPreventContextMenu({
  isMobile,
  textSelecting,
  hasSelection,
}: ContextMenuGuard): boolean {
  // 触屏：选字模式或已有选区 ⇒ 系统复制工具条优先（这条路径没有自定义复制入口）。
  // 桌面不在此列：选区存在也照样归应用，否则原生菜单会盖掉消息菜单。
  if (isMobile && (textSelecting || hasSelection)) return false;
  // 其余：拦掉浏览器默认菜单，桌面弹自定义消息菜单（移动端由长按 ActionSheet 接管）。
  return true;
}
