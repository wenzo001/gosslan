/**
 * 消息文字选区的读取与判定（桌面「复制选中内容」与移动端「让位系统选字」共用）。
 *
 * 为什么单独一个文件：`App.vue` 的全局 contextmenu 兜底、`MessageItem` 的右键、
 * 长按面板的第二道闸门都要回答同一件事 ——「这次手势是不是落在可选的正文上 / 当前有没有
 * 有效选区」。各写一遍必然漂，本仓已经在"同一个判定两个家"上翻过车。
 *
 * 这里全是 DOM 读取，不依赖 store；Node 单测跑不了真实选区，这一族由运行时探针覆盖。
 */

/** 当前是否存在**非折叠且有可见文字**的选区（空选区不算）。 */
export function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

/**
 * 落点是不是**可选正文**（触屏下只有它让位给系统原生选字）。
 *
 * 标记是 `.gosslan-selectable`（`MessageTextBubble` 的正文层，以及代码块）：
 * style.css 在 `pointer: coarse` 下只给这一层 `user-select: text`，其余消息内容
 * （昵称/引用块/卡片/内边距）都是 none ⇒ 那里长按归自定义消息面板。
 */
export function isSelectableTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(".gosslan-selectable");
}

/**
 * 当前选区里与 `root`（本次右键所在的消息内容列）**相交**的那段文本。
 *
 * · 空选区 / 折叠 / 只有空白 ⇒ 空串（菜单不显示「复制选中内容」）；
 * · 跨节点选区（正文 + 链接 + 表情）⇒ `toString()` 仍是完整文本；
 * · 选区在别条消息里 ⇒ 与 root 不相交 ⇒ 空串；
 * · 节点已被虚拟列表回收（选区失效）⇒ `intersectsNode` 会抛 ⇒ 按"没有选区"处理。
 *
 * ⚠️ 调用方必须在**打开菜单之前**取值并保存：菜单获得焦点后浏览器可能改写/收起选区，
 * 点击菜单项时再读 `window.getSelection()` 会拿到另一段（或空）文本。
 */
export function selectionTextWithin(root: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  const text = sel.toString();
  if (!text.trim()) return "";
  try {
    return sel.getRangeAt(0).intersectsNode(root) ? text : "";
  } catch {
    return "";
  }
}
