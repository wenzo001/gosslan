/**
 * 消息行右键/长按的默认行为闸门。
 *
 * 为什么要单独一个纯函数：`App.vue` 已有一条“有选区就放行系统菜单”的全局判据，
 * 而消息行曾无条件写 `@contextmenu.prevent` —— 组件级 prevent 先于全局 handler 执行，
 * 于是移动端选字时只有手柄、没有复制工具条，桌面用鼠标选中正文也吃不到系统菜单。
 * 把三个信号收在这里，组件与测试用同一份判断。
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
  // 有选区：系统复制菜单优先，任何平台都不拦。
  if (hasSelection) return false;
  // 移动端选择模式：即使选区刚刚被清空，也让系统手柄/工具条接管。
  if (isMobile && textSelecting) return false;
  // 其余：拦掉浏览器默认菜单，桌面弹自定义消息菜单（移动端由长按 ActionSheet 接管）。
  return true;
}
